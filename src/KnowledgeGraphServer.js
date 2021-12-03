const pbfUtils = require('./utilities/pbfUtils')
const quantizationUtils = require('./utilities/quantizationUtils')
const { Parser } = require('node-sql-parser/build/postgresql')
const config = require('config')
const Logger = require('@koopjs/logger')
const log = new Logger(config)

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

function getGraphCount (rows) {

}

function convertGraphToGeoJSON (rows, transformObj) {
  return {
    type: 'FeatureCollection',
    features: rows.map((inputFeature) => {
      return formatFeature(inputFeature, transformObj)
    })
  }
}

function formatFeature (inputFeature, transformObj) {
  const entity = inputFeature.values[0].entityValue
  const shape = (entity.properties.shape?.toJSON())?.primitiveValue.geometryValue

  const featureProps = {}
  for (let key in entity.properties) {
    // need to handle more cases
    if (key !== 'shape') {
      const entityValue = entity.properties[key].toJSON()
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
  for (const entityIdx in dataModel.entityTypes) {
    const entity = dataModel.entityTypes[entityIdx].entity.toJSON()

    const layer = entityJSONtoFCMetadata(entity)
    if (layer.metadata.geometryType) {
      layers.push(entity)
    } else {
      // table ids currently
      tables.push(entity)
    }
  }
  return { layers: layers, tables: tables }
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

              resolve(data)
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

  getEntityById (layerIdStr, query) {
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

  queryEntity (entity, query) {
    let namespace = 'n'
    let openCypherQuery = 'match (' + namespace + ':' + entity + ') '
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
      openCypherQuery += 'where ' + where + ' '
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
    openCypherQuery += `return ${namespace}`// "return " + (query.returnCountOnly ? "count(" + namespace + ")" : namespace);

    if (query.resultRecordCount) {
      openCypherQuery += ' limit ' + query.resultRecordCount
    }

    log.debug('openCypyerQuery', openCypherQuery)

    return this.query(openCypherQuery, query)
  }

  query (openCypherQuery, query) {
    const callback = new Promise((resolve, reject) => {
      let callURL = this.url + '/graph/query/?openCypherQuery=' + encodeURIComponent(openCypherQuery)
      if (query.geometry) {
        callURL += '&geometry=' + encodeURIComponent(JSON.stringify(query.geometry)) + `&geometryType=${query.geometryType}&inSR=${query.inSR}`
      }

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
                count: getGraphCount(data.results.rows)
              }
            } else {
              geojson = convertGraphToGeoJSON(data.results.rows, data.header.transform)
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
}

module.exports = KnowledgeGraphServer
