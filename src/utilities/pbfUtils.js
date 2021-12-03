const protobuf = require('protobufjs')
require('./EsriKnowledgeGraph')
const gzip = require('gzip-js')
const uuid = require('uuid')
const fetch = require('node-fetch')

const uuidParse = uuid.parse

const esriPBuffer = protobuf.roots.default.esriPBuffer

/**
 * Uses fetch to retrieve data from a pbf REST endpoint
 * @param {*} url
 * @param {*} method
 * @param {*} body
 * @returns
 */
const knowledgeGraphFetch = (url, method, body, headers) => {
  const defaultHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return fetch(url, {
    method: method,
    headers: {
      ...defaultHeaders,
      ...headers
    },
    body: body
  })
}

/**
 * Uses fetch to post to a pbf REST endpoint
 * @param {*} url
 * @param {*} method
 * @param {*} body
 * @returns
 */
const knowledgeGraphPOST = (url, method, body) => {
  return fetch(url, {
    method: method,
    headers: {
      'Content-Type': 'application/octet-stream'
    },
    body: body
  })
}

/**
 * Constructs the "adds" object for applyEdits for a new entity from the pbf conversion library
 * @param {*} type
 * @param {*} entityProps
 * @returns
 */
const constructEntityAddObj = (type, entityProps) => {
  const props = {}
  for (const [key, value] of Object.entries(entityProps)) {
    if (value.primitiveFieldType === 'geometryValue') {
      // Geometry is a special handling case
      const esriDefaultGeometry =
        esriPBuffer.graph.GeometryValue.EsriDefaultGeometry.fromObject({
          coords: [value.x, value.y],
          lengths: [1]
        })
      const geometryValue = esriPBuffer.graph.GeometryValue.fromObject({
        geometry: esriDefaultGeometry
      })
      const primitiveValue = esriPBuffer.graph.PrimitiveValue.fromObject({
        geometryValue: geometryValue
      })
      const anyValNamePbf = esriPBuffer.graph.AnyValue.fromObject({
        primitiveValue: primitiveValue
      })
      props[key] = anyValNamePbf
    } else {
      const primitiveValue = {}
      primitiveValue[value.primitiveFieldType] = value.value
      const anyValNamePbf = esriPBuffer.graph.AnyValue.fromObject({
        primitiveValue: primitiveValue
      })
      props[key] = anyValNamePbf
    }
  }

  const namedObjectAddPbf = esriPBuffer.graph.NamedObjectAdd.fromObject({
    properties: props
  })

  const namedObjectAddsArray = [namedObjectAddPbf]

  const namedObjectAddsPbf = esriPBuffer.graph.NamedObjectAdds.fromObject({
    namedObjectAdds: namedObjectAddsArray
  })

  const entitiesMap = {}
  entitiesMap[type] = namedObjectAddsPbf

  return entitiesMap
}

/**
 * Constructs the "adds" object for applyEdits for a new relationship from the pbf conversion library
 * @param {*} sourceId
 * @param {*} targetId
 * @param {*} relationshipType
 * @returns
 */
const constructRelationshipAddObj = (sourceId, targetId, relationshipType) => {
  const editedSourceId = sourceId.replace(/[{}]/g, '')
  const editedTargetId = targetId.replace(/[{}]/g, '')

  const originGlobalIDbytes = uuidParse(editedSourceId)
  const destinationGlobalIDbytes = uuidParse(editedTargetId)

  const anyValIDPbf = esriPBuffer.graph.AnyValue.fromObject({
    primitiveValue: {
      sint64Value: -1
    }
  })

  const anyValOriginGlobalIDPbf = esriPBuffer.graph.AnyValue.fromObject({
    primitiveValue: {
      uuidValue: originGlobalIDbytes
    }
  })

  const anyValDestinationGlobalIDPbf = esriPBuffer.graph.AnyValue.fromObject({
    primitiveValue: {
      uuidValue: destinationGlobalIDbytes
    }
  })

  const props = {
    id: anyValIDPbf,
    originGlobalID: anyValOriginGlobalIDPbf,
    destinationGlobalID: anyValDestinationGlobalIDPbf
  }

  const namedObjectAddPbf = esriPBuffer.graph.NamedObjectAdd.fromObject({
    properties: props
  })

  const namedObjectAddsArray = [namedObjectAddPbf]

  const namedObjectAddsPbf = esriPBuffer.graph.NamedObjectAdds.fromObject({
    namedObjectAdds: namedObjectAddsArray
  })

  const relMap = {}
  relMap[relationshipType] = namedObjectAddsPbf

  return relMap
}

/**
 * POSTS a provided header and frame as applyEdits to the provided endpoint.
 * @param {*} url
 * @param {*} header
 * @param {*} frame
 * @returns
 */
const postApplyEdits = (url, header, frame) => {
  // serialize
  const postBodyWriter =
    esriPBuffer.graph.GraphApplyEditsHeader.encodeDelimited(header)
  const frameWriter = esriPBuffer.graph.GraphApplyEditsFrame.encode(frame)
  const frameAsBytes = frameWriter.finish()
  const frameCompressed = gzip.zip(frameAsBytes)
  postBodyWriter.bytes(frameCompressed)
  const postBodyBuffer = postBodyWriter.finish()

  // POST apply edits and parse response
  const parseResponse = (blob, resolve) => {
    blob.arrayBuffer().then(function (buffer) {
      const reader = protobuf.Reader.create(new Uint8Array(buffer))
      let responseObj = {}

      try {
        responseObj = esriPBuffer.graph.GraphApplyEditsResult.decode(reader)
      } catch (ex) {
        responseObj = {
          error: ex
        }
      }
      resolve(responseObj)
    })
  }
  return new Promise((resolve) =>
    knowledgeGraphPOST(url, 'POST', postBodyBuffer)
      .then((responseBlob) => {
        parseResponse(responseBlob, resolve)
      })
      .catch((error) => {
        resolve(error)
      })
  )
}

const pbfUtils = {
  /**
   * Takes a provided entityProps of a given type, constructs an applyEdits pbf object, and POSTS to the endpoint
   * @param {*} url
   * @param {*} entityType
   * @param {*} entityProps
   * @param {*} transform
   * @returns
   */
  addEntity: (url, entityType, entityProps, transform) => {
    // Apply Edits Header
    const scale = esriPBuffer.EsriTypes.Scale.fromObject(transform.scale)
    const translate = esriPBuffer.EsriTypes.Translate.fromObject(
      transform.translate
    )
    const transformObj = esriPBuffer.EsriTypes.Transform.fromObject({
      scale: scale,
      translate: translate
    })
    const header = esriPBuffer.graph.GraphApplyEditsHeader.fromObject({
      minorVersion: 2,
      inputTransform: transformObj
    })

    // Apply Edits Frame
    const entityAdds = constructEntityAddObj(entityType, entityProps)
    const adds = esriPBuffer.graph.Adds.fromObject({
      entities: entityAdds
    })
    const frame = esriPBuffer.graph.GraphApplyEditsFrame.fromObject({
      adds: adds
    })

    return postApplyEdits(url, header, frame)
  },

  /**
   * Takes a provided relationshipProps of a given type, constructs an applyEdits pbf object, and POSTS to the endpoint
   * @param {*} url
   * @param {*} entityType
   * @param {*} entityProps
   * @param {*} transform
   * @returns
   */
  addRelationship: (url, sourceId, targetId, relationshipType) => {
    // Apply Edits Header
    const header = esriPBuffer.graph.GraphApplyEditsHeader.fromObject({
      minorVersion: 2
    })

    // Apply Edits Frame
    const relAdds = constructRelationshipAddObj(
      sourceId,
      targetId,
      relationshipType
    )
    const adds = esriPBuffer.graph.Adds.fromObject({
      relationships: relAdds
    })
    const frame = esriPBuffer.graph.GraphApplyEditsFrame.fromObject({
      adds: adds
    })

    return postApplyEdits(url, header, frame)
  },

  /**
   * Retrieves the datamodel from a provided endpoint
   * @param {*} url
   * @returns
   */
  queryDataModel: (url) => {
    // require('util').inspect.defaultOptions.depth = null
    const parseData = (blob, resolve, reject) => {
      blob.arrayBuffer().then(function (buffer) {
        const reader = protobuf.Reader.create(new Uint8Array(buffer))
        let responseObj = {}

        try {
          responseObj = esriPBuffer.graph.GraphDataModel.decode(reader)
        } catch (ex) {
          reject(new Error('Exception decoding response - datamodel: ', ex))
        }
        resolve(responseObj)
      })
    }

    return new Promise((resolve, reject) =>
      knowledgeGraphFetch(url, 'GET')
        .then(response => {
          const contentType = response.headers.get('Content-Type')
          if (contentType.startsWith('application/json')) {
            response.json().then(json => {
              reject(json)
            })
          } else {
            response.blob().then(blob => {
              parseData(blob, resolve, reject)
            })
          }
        })
        .catch((error) => {
          resolve(error)
        })
    )
    // return new Promise((resolvePromise) =>
    //   knowledgeGraphFetch(url, "GET")
    //     .then((response) => response.blob()).then(blob => {
    //       parseData(blob, resolvePromise);
    //     })
    //     .catch((error) => {
    //       resolvePromise(error);
    //     })
    // );
  },
  /*
   * Queries the provided url for arcKnowledge Graph data
   * Returns promise
   * must be in f=pbf format
   * assumes token is provided if needed and openCypher param
   */
  queryGraph: (url, headers) => {
    // parse the blob into a javascript object according to the proto definition
    const parseData = (blob, resolve, reject) => {
      blob.arrayBuffer().then(function (buffer) {
        let readFrames = true
        let reader = protobuf.Reader.create(new Uint8Array(buffer))
        const responseObj = {
          header: null,
          results: null
        }

        try {
          const header =
            esriPBuffer.graph.GraphQueryResultHeader.decodeDelimited(reader)
          responseObj.header = header
        } catch (ex) {
          //'Exception decoding response header
          // responseObj.error = ex;
          // readFrames = false;
          // Need to reset the reader to get errors returned from the server in the frames
          reader = protobuf.Reader.create(new Uint8Array(buffer))
        }

        while (readFrames) {
          try {
            // For POST Requests
            // 1. First get compressed ResultFame bytes
            // 2. Decompress ResultFrame and then create GraphQueryResultFrame from decompressed bytes
            const frame =
              esriPBuffer.graph.GraphQueryResultFrame.decodeDelimited(reader)

            if (frame.error) {
              responseObj.error = frame.error
              readFrames = false
              break
            }
            if (!responseObj.results) {
              // first frame - results object is the frame
              responseObj.results = frame
            } else {
              // subsequent frames are additional data
              // TODO - need to test that this works as expected
              responseObj.results.rows = responseObj.results.rows.concat(
                frame.rows
              )
            }
          } catch (ex) {
            readFrames = false
          }
        }
        resolve(responseObj)
      })
    }

    return new Promise((resolve, reject) =>
      knowledgeGraphFetch(url, 'GET', null, headers)
        .then(response => {
          const contentType = response.headers.get('Content-Type')
          
          if (contentType.startsWith('application/json')) {
            response.json().then(json => {
              reject(json.error)
            })
          } else {
            response.blob().then(blob => {
              parseData(blob, resolve, reject)
            })
          }
        })
        .catch((error) => {
          resolve(error)
        })
    )
  }
}

module.exports = pbfUtils
