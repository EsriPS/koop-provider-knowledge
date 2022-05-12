const pbfUtils = require('./utilities/pbfUtils')
const quantizationUtils = require('./utilities/quantizationUtils')
const { Parser } = require('node-sql-parser/build/postgresql')
const config = require('config')
const Logger = require('@koopjs/logger')
const log = new Logger(config)
const { toGeographic, positionToGeographic } = require('@terraformer/spatial')
const { arcgisToGeoJSON } = require('@terraformer/arcgis')
const { geojsonToWKT } = require('@terraformer/wkt')
const _ = require('lodash')
const fromExponential = require('from-exponential')

/**
 * Transform a value with an array of coords from quantized to unquantized format
 * @param {*} value An entity object with a coords array
 * @param {*} transformObj The quantization transform object from the
 * @returns
 */
function getTransformedCoordinateArray (value, transformObj) {
  let prevPoint = []
  const coordArray = []
  const transform = quantizationUtils.createTransform(transformObj)
  const inverseTransform = quantizationUtils.createInverseTransform(transform)
  let transformedPoint = {}
  // first point is handled normally
  transformedPoint = quantizationUtils.transformPoint(
    [
      Number(value.coords[0]),
      Number(value.coords[1])
    ],
    inverseTransform
  )
  coordArray.push(transformedPoint)
  prevPoint = [Number(value.coords[0]), Number(value.coords[1])]
  for (
    let i = 2;
    i + 1 < value.coords.length;
    i = i + 2
  ) {
    // iterate through points as pairs
    const point = [
      prevPoint[0] + Number(value.coords[i]),
      prevPoint[1] + Number(value.coords[i + 1])
    ]
    const transformedPoint = quantizationUtils.transformPoint(point, inverseTransform)
    coordArray.push(transformedPoint)
    prevPoint[0] = prevPoint[0] + Number(value.coords[i])
    prevPoint[1] = prevPoint[1] + Number(value.coords[i + 1])
  }
  return coordArray
}

function convertGraphToRelationshipGeoJSON (rows, geometryField, transformObj) {
  const features = []
  let currentRel = {
    type: 'FeatureCollection',
    features: [],
    properties: {
    }
  }

  rows.forEach((row, idx) => {
    const rowJSON = row
    const featureRow = rowJSON.values[0].toJSON()
    const rowOId = Number(featureRow.entityValue.properties.objectid.primitiveValue.sint64Value)

    if (currentRel.properties.objectid !== rowOId) {
      if (currentRel.properties.objectid >= -1) {
        features.push(currentRel)
      }

      currentRel = {
        type: 'FeatureCollection',
        features: [],
        properties: {
          objectid: Number(rowOId)
        }
      }
    }

    currentRel.features.push(formatFeature(rowJSON.values[1].entityValue, geometryField, transformObj))
  })

  if (currentRel.properties.objectid >= -1) {
    features.push(currentRel)
  }

  return {
    type: 'FeatureCollection',
    features: features
  }
}

function convertGraphToGeoJSON (rows, geometryField, transformObj) {
  return {
    type: 'FeatureCollection',
    features: rows.map((inputFeature) => {
      return formatFeature(inputFeature.values[0].entityValue, geometryField, transformObj)
    })
  }
}

function formatFeature (entity, geometryField, transformObj) {
  const shape = geometryField ? (entity.properties[geometryField]?.toJSON())?.primitiveValue.geometryValue : null

  const featureProps = {}
  for (let key in entity.properties) {
    // need to handle more cases
    if (key !== geometryField) {
      const entityValue = entity.properties[key].toJSON()
      if (entityValue.primitiveValue) {
        const firstKey = Object.keys(entityValue.primitiveValue)[0]
        let val = entityValue.primitiveValue[firstKey]
        // todo handle dates
        if (firstKey.includes('int') || firstKey.includes('float')) {
          val = Number(val)
        }
        if (key === 'objectid') {
          key = key.toUpperCase()
        }
        featureProps[key] = val
      }
    }
  }

  const feature = {
    type: 'Feature',
    properties: featureProps,
    geometry: shape ? convertGeometry(shape, transformObj) : null
  }

  return feature
}

function convertGeometry (shapeGeometryValue, transformObj) {
  let featureGeomType = 'Point'
  let featureCoords = []
  const geometry = shapeGeometryValue.geometry

  switch (shapeGeometryValue.geometryType) {
    case 'esriGeometryTypePolygon':
      featureGeomType = 'Polygon'
      featureCoords.push(getTransformedCoordinateArray(geometry, transformObj))
      break
    case 'esriGeometryTypePolyline':
      featureGeomType = 'LineString'
      featureCoords = getTransformedCoordinateArray(geometry, transformObj)
      break
    case 'esriGeometryTypeMultipoint':
      featureGeomType = 'MultiPoint'
      featureCoords = getTransformedCoordinateArray(geometry, transformObj)
      break
    default:
      featureGeomType = 'Point'
      featureCoords = getTransformedCoordinateArray(geometry, transformObj)[0]
      break
  }

  return {
    type: featureGeomType,
    coordinates: featureCoords
  }
}

function addNamespaceToASTWhere (namespace, where) {
  if (where) {
    if (where.type === 'column_ref') {
      where.table = namespace
    }
    if (where.left) {
      addNamespaceToASTWhere(namespace, where.left)
    }

    if (where.right) {
      addNamespaceToASTWhere(namespace, where.right)
    }
  }
}

function addNamespaceToAST (namespace, ast) {
  if (ast) {
    const where = ast.where
    if (where) {
      if (where.left) {
        addNamespaceToASTWhere(namespace, where.left)
      }

      if (where.right) {
        addNamespaceToASTWhere(namespace, where.right)
      }
    }
  }
}

function sqlToOpenCypherWhere (sqlStmt) {
  let where = sqlStmt.substring(sqlStmt.indexOf('WHERE ') + 'WHERE '.length)
  where = where.replace(/"/g, '')
  where = where.replace(/ [iI][nN] \(/g, ' IN [')
  where = where.replace(/( [iI][nN] \[[^)]*)\)/, '$1]')
  return where
}

function convertDataModelToFCs (dataModel) {
  const layers = []
  const tables = []
  const relationships = []
  const layerTableMap = {}
  for (const entityIdx in dataModel.entityTypes) {
    const entity = dataModel.entityTypes[entityIdx].entity.toJSON()

    const layer = entityJSONtoFCMetadata(entity)
    layerTableMap[entity.name] = layer
    if (layer.metadata.geometryType) {
      layers.push(layer)
    } else {
      // table ids currently
      tables.push(layer)
    }
  }

  layers.forEach((layer, idx) => {
    layer.metadata.id = idx
  })

  tables.forEach((table, idx) => {
    table.metadata.id = layers.length + idx
  })

  dataModel.relationshipTypes.forEach(relationship => {
    relationship.originEntityTypes.forEach((originEntityType) => {
      relationship.destEntityTypes.forEach((destEntityType) => {
        const relJSON = buildRelationshipsJSON(
          relationships.length,
          relationship.relationship.name,
          layerTableMap[originEntityType].metadata.id,
          layerTableMap[destEntityType].metadata.id)

        layerTableMap[originEntityType].metadata.relationships.push(relJSON[0])
        relationships.push(relJSON[0])

        if (originEntityType !== destEntityType) {
          layerTableMap[destEntityType].metadata.relationships.push(relJSON[1])
          // relationships.push(relJSON[1])
        }
      })
    })
  })
  return { layers, tables, relationships }
}

function buildRelationshipsJSON (id, name, originId, destId) {
  return [
    buildRelationshipJSON(id, name, destId, 'esriRelCardinalityOneToMany', 'esriRelRoleOrigin', 'originGlobalID', false),
    buildRelationshipJSON(id, name, originId, 'esriRelCardinalityOneToMany', 'esriRelRoleDestination', 'destinationGlobalID', false)
  ]
}

function buildRelationshipJSON (id, name, relatedTableId, cardinality, role, keyField, composite) {
  return {
    id,
    name,
    relatedTableId,
    cardinality,
    role,
    keyField,
    composite
  }
}

function entityJSONtoFCMetadata (entity) {
  const layer = {
    type: 'FeatureCollection',
    features: []
  }
  const metadata = layer.metadata = {}

  metadata.name = entity.name
  metadata.description = entity.name
  metadata.extent = [[180, 90], [-180, -90]]
  metadata.fields = []
  metadata.relationships = []

  let geomType = null
  for (const propIdx in entity.properties) {
    const prop = entity.properties[propIdx]

    metadata.fields.push({
      name: prop.name === 'objectid' ? prop.name.toUpperCase() : prop.name,
      alias: prop.alias,
      type: prop.fieldType.replace('esriFieldType', '')
    })

    if (prop.fieldType === 'esriFieldTypeGeometry') {
      if (prop.geometryType === 'esriGeometryTypePolygon') {
        geomType = 'Polygon'
      } else if (prop.geometryType === 'esriGeometryTypePolyline') {
        geomType = 'LineString'
      } else if (prop.geometryType === 'esriGeometryTypeMultipoint') {
        geomType = 'Point'
      } else {
        // protobuf will remove the geometryType attribute for points, so set it as default
        geomType = 'Point'
      }
    }
  }
  metadata.geometryType = geomType

  metadata.idField = 'OBJECTID'
  return layer
}

class KnowledgeGraphServer {
  constructor (url, token) {
    this.url = url
    this.token = token
    this.dataModel = null
    this.layers = null
    this.tables = null
  }

  getDataModel (query) {
    const callback = new Promise((resolve, reject) => {
      if (this.dataModel) {
        resolve(this.dataModel)
      } else {
        const token = query.token ? query.token : this.token
        const callURL = encodeURI(`${this.url}/dataModel/queryDataModel?f=pbf` + (token != null ? `&token=${token}` : ''))

        // retrieve data model schema for endpoint
        pbfUtils.queryDataModel(callURL)
          .then((data) => {
            if (data.globalidProperty) {
              // decided against caching the datamodel at this time to support passing security down to AGS
              // this.dataModel = data;
              const layersAndTables = convertDataModelToFCs(data)
              this.layers = layersAndTables.layers
              this.tables = layersAndTables.tables
              this.relationships = layersAndTables.relationships

              resolve({ dataModel: data, FCs: layersAndTables })
            } else {
              log.error('Error in retrieval of Data Model from AKG endpoint', data)
              this.dataModel = null
              reject(new Error('Error in retrieval of Data Model from AKG endpoint'))
            }
          }).catch(error => {
            reject(error)
          })
      }
    })
    return callback
  }

  getEntityById (layerIdStr, query = {}) {
    const callback = new Promise((resolve, reject) => {
      this.getDataModel(query).then((dataModel) => {
        let layerId = -1
        try {
          layerId = Number.parseInt(layerIdStr)
        } catch (e) {
          log.error("couldn't parse layerId", e)
          reject(new Error("couldn't parse layerId"))
        }

        if (layerId > -1) {
          const entity = layerId >= this.layers.length ? this.tables[layerId - this.layers.length] : this.layers[layerId]// dataModel.entityTypes[layerId] ? dataModel.entityTypes[layerId].entity.toJSON() : null;

          if (entity) resolve(entity)
          else reject(new Error('invalid layerId'))
        } else {
          reject(new Error('invalid layerId'))
        }
      }).catch(error => {
        reject(error)
      })
    })

    return callback
  }

  async queryEntity (entity, query = {}) {
    let namespace = 'n'
    let openCypherQuery = 'match (' + namespace + ':' + entity.metadata.name + ') '

    let { where, objectIds } = query

    if (query && ((where && where !== '1=1') || objectIds)) {
      // https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer-.htm
      // todo add support for:
      // * geometry/geometryType?
      // * time?
      // * distance - buffer?
      // * outFields
      // * returnGeometry
      // * havingClause?
      // * returnDistinctValues?
      // * returnCountOnly
      
      if (objectIds) {
        where = `objectid in (${objectIds})`
      }

      // will this always be the case that the entityType has objectid lowercase and koop wants it upper?
      where = where.replace(/OBJECTID/ig, 'objectid')

      const parser = new Parser()
      const ast = parser.astify(`SELECT * FROM BLAH as n WHERE ${where}`)
      addNamespaceToAST(namespace, ast)
      where = sqlToOpenCypherWhere(parser.sqlify(ast))
      openCypherQuery += `where ${where} `
    }

    const { returnIdsOnly, resultRecordCount, geometry, geometryType, spatialRel = 'esriSpatialRelIntersects' } = query

    if (geometry) {
      let method = 'ST_Intersects'
      switch (spatialRel) {
        case 'esriSpatialRelIntersects':
          method = 'ST_Intersects'
          break;
        case 'esriSpatialRelContains':
          method = 'ST_Contains'
          break;
      }

      try {
      //TODO ideally this projection will occur with @arcgis/core/geometry/projection however the whole
      // project might need to be converted to an ES Module to allow use
      // const wgsGeom = projection.project(geometry, {wkid:4326})
      // Check if point or extent array format
      if (_.isString(geometry)) {
        const coords = geometry.split(',')
        if (coords.length === 2) {
          geometry = {
            'x': coords[0],
            'y': coords[1],
            'spatialReference': _.isObject(inSR) ? inSR : { 'wkid': query.inSR || 4326 }
          }
        } else if (coords.length === 4) {
          geometry = {
            'xmin': coords[0],
            'ymin': coords[1],
            'xmax': coords[2],
            'ymax': coords[3],
            'spatialReference': _.isObject(inSR) ? inSR : { 'wkid': query.inSR || 4326 }
          }
        }
      }

      let geometries = [geometry]
      // TODO what if the geometry is a polygon or line that's too wide?
      // Determine if the Envelope is >180 deg, if so the knwowledge graph will error
      if (_.has(geometry, 'xmin') && _.has(geometry, 'xmax')) {
        if (geometry?.spatialReference?.wkid === 102100) {
          const convMin = positionToGeographic([geometry.xmin, geometry.ymin])
          // decimal degree precision doesn't need to be more than 6 places and was getting
          // features with exponential precision if rounding doesn't occur
          geometry.xmin = Math.round(convMin[0]*1000000.0)/1000000.0
          geometry.ymin = Math.round(convMin[1]*1000000.0)/1000000.0
          const convMax = positionToGeographic([geometry.xmax, geometry.ymax])
          geometry.xmax = Math.round(convMax[0]*1000000.0)/1000000.0
          geometry.ymax = Math.round(convMax[1]*1000000.0)/1000000.0
          geometry.spatialReference.wkid = 4386
        }
        const delta = Math.abs(geometry.xmax - geometry.xmin)
        console.log("delta", delta)
        if (delta >= 180) {
          console.log("***LARGE POLYGON", geometry)
          let parts = delta >= 360 ? 4 : 2
          for (let i = 1; i<parts; i++) {
            let geom = geometries[i-1]
            let extent = _.clone(geom)
            geom.xmax = geom.xmin + delta/parts
            extent.xmin = geom.xmax
            geometries.push(extent)
          }
        }
      }
      console.log(geometries)
      const field = entity.metadata.fields.find(field => field.type === 'Geometry')

      const geoCypher = geometries.map( (geometry) => {
        if (_.has(geometry, 'xmin') && _.has(geometry, 'xmax')) {
          geometry.xmin = Math.round(geometry.xmin*1000000.0)/1000000.0
          geometry.ymin = Math.round(geometry.ymin*1000000.0)/1000000.0
          geometry.xmax = Math.round(geometry.xmax*1000000.0)/1000000.0
          geometry.ymax = Math.round(geometry.ymax*1000000.0)/1000000.0
        }
        let geojsonGeom = arcgisToGeoJSON(geometry)
        if (geometry?.spatialReference?.wkid === 102100) {
          geojsonGeom = toGeographic(geojsonGeom)
        }

        const wktGeometry = geojsonToWKT( geojsonGeom )
        return `esri.graph.${method}(esri.graph.ST_WKTToGeometry("${wktGeometry}"), ${namespace}.${field.name})`
      })
      openCypherQuery += openCypherQuery.indexOf('where ') > 0 ? 'and ' : 'where '
      openCypherQuery += '(' + geoCypher.join(' OR ') + ') '
    } catch (err) {
      console.log(err)
    }
    }

    // const outFields = query.outFields
    if (returnIdsOnly && returnIdsOnly === 'true') {
      namespace = namespace + '.objectid'
    }
    // TODO figure out best way to filter fields, may require enhancing the parsing of responses
    // else if (outFields && outFields.trim().length > 0) {
    //     namespace = 'n.' + outFields.split(/\s*,\s*/).join(`, ${namespace}.`)
    // }

    // todo add query.returnCountOnly validation
    openCypherQuery += `return ${namespace}`// "return " + (query.returnCountOnly ? "count(" + namespace + ")" : namespace);

    if (resultRecordCount) {
      openCypherQuery += ` limit ${resultRecordCount}`
    }

    log.debug('openCypyerQuery', openCypherQuery)

    return this.query(entity, openCypherQuery, query)
  }

  query (entity, openCypherQuery, query, isRelationship = false) {
    const callback = new Promise((resolve, reject) => {
      let callURL = this.url + '/graph/query/?openCypherQuery=' + encodeURIComponent(openCypherQuery)
      // if (query.geometry) {
      //   callURL += '&geometry=' + encodeURIComponent(JSON.stringify(query.geometry)) + `&geometryType=${query.geometryType}&inSR=${query.inSR}`
      // }

      log.debug('Calling (url (no token version)' + callURL)

      const token = query.token ? query.token : this.token
      callURL += '&f=pbf' + (token != null ? `&token=${token}` : '')

      pbfUtils.queryGraph(callURL, { Referer: 'http://koopjs.esri.com' }).then(data => {
        if (data && !data.error) {
          if (data.results && data.results.rows) {
            let geojson = null
            if (query.returnCountOnly && query.returnCountOnly === 'true') {
              geojson = {
                type: 'FeatureCollection',
                features: [],
                count: data.results.rows.length
              }
            } else {
              const field = entity.metadata.fields.find(field => field.type === 'Geometry')
              if (isRelationship) geojson = convertGraphToRelationshipGeoJSON(data.results.rows, field?.name, data.header.transform)
              else geojson = convertGraphToGeoJSON(data.results.rows, field?.name, data.header.transform)
            }
            geojson.metadata = { idField: 'OBJECTID' }

            // https://github.com/koopjs/FeatureServer#featureserverroute
            geojson.filtersApplied = { where: true, geometry: true }

            resolve(geojson)
          } else {
            // Case no rows are returned from server
            resolve({
              type: 'FeatureCollection',
              features: []
            })
          }
        } else {
          // todo better return error message
          reject(data.error)
        }
      }).catch(error => {
        log.error('ERROR: ', error)
        reject(error)
      })
    })

    return callback
  }

  queryRelatedRecords (entity, query) {
    const { relationshipId } = query

    const entityRel = entity.metadata.relationships.find(rel => rel.id === relationshipId)

    const callback = new Promise((resolve, reject) => {
      this.getEntityById(entityRel.relatedTableId, query).then(newEntity => {
        let namespace = 'n'
        const otherNamespace = 'm'
        let originDirection = '>'
        let destDirection = ''
        if (entityRel.role === 'esriRelRoleDestination') {
          originDirection = ''
          destDirection = '<'
        }

        let openCypherQuery = `match (${namespace}:${entity.metadata.name})${destDirection}-[r:${entityRel.name}]-${originDirection}(${otherNamespace}:${newEntity.metadata.name})`

        if (query && ((query.where && query.where !== '1=1') || query.objectIds)) {
          // https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer-.htm
          // todo add support for:
          // * geometry/geometryType?
          // * time?
          // * distance - buffer?
          // * outFields
          // * returnGeometry
          // * havingClause?
          // * returnDistinctValues?
          // * returnCountOnly
          let where = query.where

          if (query.objectIds) {
            where = `objectid in (${query.objectIds})`
          }

          // will this always be the case that the entityType has objectid lowercase and koop wants it upper?
          where = where.replace(/OBJECTID/ig, 'objectid')

          const parser = new Parser()
          const ast = parser.astify('SELECT * FROM BLAH as n WHERE ' + where)
          addNamespaceToAST(namespace, ast)
          where = sqlToOpenCypherWhere(parser.sqlify(ast))
          openCypherQuery += `where ${where} `
        }

        // const outFields = query.outFields
        if (query.returnIdsOnly && query.returnIdsOnly === 'true') {
          namespace = namespace + '.objectid'
        }
        // TODO figure out best way to filter fields, may require enhancing the parsing of responses
        // else if (outFields && outFields.trim().length > 0) {
        //     namespace = 'n.' + outFields.split(/\s*,\s*/).join(`, ${namespace}.`)
        // }

        // todo add query.returnCountOnly validation
        openCypherQuery += `return ${namespace},${otherNamespace} order by ${namespace}.objectid`// "return " + (query.returnCountOnly ? "count(" + namespace + ")" : namespace);

        if (query.resultRecordCount) {
          openCypherQuery += ` limit ${query.resultRecordCount}`
        }

        log.debug('openCypyerQuery', openCypherQuery)

        this.query(newEntity, openCypherQuery, query, true).then(data => {
          if (!data.metadata) data.metadata = {}
          data.metadata.fields = newEntity.metadata.fields
          resolve(data)
        }).catch(error => reject(error))
      })
    })

    return callback
  }
}

module.exports = KnowledgeGraphServer
