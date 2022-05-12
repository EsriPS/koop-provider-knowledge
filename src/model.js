const KnowledgeGraphServer = require('./KnowledgeGraphServer')
const config = require('config')
const Logger = require('@koopjs/logger')
const log = new Logger(config)

function Model (koop) {
  koop.server.get('/rest/info', function (req, res) {
    res.status(200).send('Welcome to Koop!')
  })
  this.kgServers = {}
  const kpConfig = config['provider-knowledge']
  if (kpConfig && kpConfig.sources) {
    for (const [key, source] of Object.entries(kpConfig.sources)) {
      const url = source.url
      const token = source.token
      if (url && url.trim().length > 0) {
        log.info(`creating ${key}`, 'token exists?', token != null)
        this.kgServers[key] = new KnowledgeGraphServer(url, token)
      }
    }
  }
}

// each model should have a getData() function to fetch the geo data
// and format it into a geojson
Model.prototype.getData = function (req, callback) {
  const id = req.params.id
  const layer = req.params.layer
  const method = req.params.method
  const query = req.query

  if (id && this.kgServers[id]) {
    const graph = this.kgServers[id]

    // If a layer exists, perform a layer info or operation request
    if (layer) {
      // If no method then request if for layer info, return layer info for invalid operations
      // like the ArcGIS Server REST API does
      if (method == null) {
        handleLayerInfoRequest(layer, query, graph, callback)
      } else if (method === 'query') {
        handleLayerQuery(layer, query, graph, callback)
      } else if (method === 'queryRelatedRecords') {
        handleRelatedRecords(layer, query, graph, callback)
      }
    } else {
      handleServerInfoRequest(query, graph, callback)
    }
  } else {
    callback(getError(`Service ${id} not found `, 404))
  }
}

function getError (message, code = 500, stack = []) {
  return { code, message, stack }
}

function handleLayerQuery (layer, query, graph, callback) {
  graph.getEntityById(layer, query).then(entity => {
    const name = entity.metadata.name
    graph.queryEntity(entity, query).then(geojson => {
      callback(null, geojson)
    }).catch(error => {
      log.error('Query entity', name, error)
      callback(getError(error.message))
    })
  }).catch(error => {
    log.error('Query get entity by layer id', error)
    // ArcGIS Server REST API has code 500, message null for invalid layer
    callback(error)
  })
}

function handleRelatedRecords (layer, query, graph, callback) {
  graph.getEntityById(layer, query).then(entity => {
    const name = entity.metadata.name
    graph.queryRelatedRecords(entity, query).then(geojson => {
      callback(null, geojson)
    }).catch(error => {
      log.error('Query entity', name, error)
      callback(getError(error.message))
    })
  }).catch(error => {
    log.error('Query get entity by layer id', error)
    // ArcGIS Server REST API has code 500, message null for invalid layer
    callback(getError(error))
  })
}

function handleLayerInfoRequest (layer, query, graph, callback) {
  graph.getEntityById(layer, query).then(geojson => {
    callback(null, geojson)
  }).catch(error => {
    log.error('layer info error for ' + layer, error)
    callback(error)
  })
}

function handleServerInfoRequest (query, graph, callback) {
  // this is a service metadata request
  graph.getDataModel(query).then((data) => {
    callback(null, data.FCs)
  }).catch(error => {
    log.error('error in server info', error)
    callback(error)
  })
}

module.exports = Model
