const provider = {
  type: 'provider',
  version: require('../package.json').version,
  name: 'knowledge',
  disableIdParam: false,
  Model: require('./model')
}

module.exports = provider
