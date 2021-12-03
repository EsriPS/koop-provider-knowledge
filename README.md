# Koop Provider for ArcGIS Knowledge Server

This is a [Koop](http://koopjs.github.io) [provider](https://koopjs.github.io/docs/available-plugins/providers) that transforms [ArcGIS Knowledge Server](https://enterprise.arcgis.com/en/knowledge/latest/introduction/get-started-with-arcgis-knowledge.htm) graph entity data into [GeoJSON](https://geojson.org/) Feature Collections by entity type. Common usage would be to use the Koop [Geoservices](https://koopjs.github.io/docs/available-plugins/outputs) output plugin to reflect the entity GeoJSON Feature Collections as an [ArcGIS Server Feature Service](https://developers.arcgis.com/rest/services-reference/enterprise/feature-service.htm) with layers (contains geometry) and tables.

## Requirements

To support ArcGIS Enterprise authentication token pass through, the following Koop Output plugins are required

* [Koop Geoservices Output Plugin](https://github.com/koopjs/koop-output-geoservices) v3.1.0+
* [Koop FeatureServer Output Plugin](https://github.com/koopjs/FeatureServer) v3.2.0+

## Install using Koop CLI

1. Install the [Koop CLI](https://koopjs.github.io/docs/basics/quickstart)
1. Create an application
    ```
    koop new app demo-app
    cd demo-app
    ```
 1. Add the Koop Provider for ArcGIS Knowledge Server
    ```
    koop add provider koop-provider-knowledge
    ```
1. [Configure the Provider](#Configure-the-Provider) in the Koop Config
1. Start Koop
    ```
    koop serve
    ```

## Use in a Koop Application

1. Install the provider
    ```
    npm install koop-provider-knowledge
    ```
1. Add Provider to the application
    ```js
    const knowledgeProvider = require('koop-provider-knowledge')
    koop.register(knowledgeProvider)
    ```

## Configure the Provider

### AuthInfo for ArcGIS Enterprise Security Configuration
Adding an authInfo object to the koop config will allow a token service url to be specified so that clients can directly get a token from ArcGIS Enterprise. This is the recommended configuration to use the ArcGIS Knowledge Koop Provider. This is a feature of the [Koop Geoservices Output Plugin](https://github.com/koopjs/koop-output-geoservices) v3.1.0+
```json
{
	"authInfo":{
		"isTokenBasedSecurity" : true,
		"tokenServicesUrl" : "<token url>"
	  }
}
```
Example
```json
{
	"port": 8080,
	"authInfo":{
		"isTokenBasedSecurity" : true,
		"tokenServicesUrl" : "https://myserver.domain.com/portal/sharing/rest/generateToken"
	  },
      "provider-knowledge":{
          ...
      }
}
```

### Configure Services for Knowledge Provider
Named ArcGIS Knowledge Services are added to the koop configuration, while not recommended a token can be specified. This token will need to be a long lived token and updated by an administrator.
```json
{
	"provider-knowledge": {
		"sources": {
			"<key>": {
				"url": "<url>",
                "token": "<token>" // not recommended
			}
		}
	}
}
```
Examples with and without token
```json
{
	"port": 8080,
	"authInfo":{
		...
	  },
	"provider-knowledge": {
		"sources": {
			"MyKnowledgeService": {
				"url": "https://myserver.domain.com/server/rest/services/Hosted/MyKnowledgeService/KnowledgeGraphServer"
			},
            "MyKnowledgeServiceWithToken": {
				"url": "https://myserver.domain.com/server/rest/services/Hosted/MyKnowledgeService/KnowledgeGraphServer",
                "token": "<Token Generated from ArcGIS Enterprise>"
			}
		}
	}
}
```

The following is a sample configuration file showing most capabilities in the recommended configuration, if using the Koop CLI look under config/default.json
```json
{
	"port": 8080,
	"authInfo":{
		"isTokenBasedSecurity" : true,
		"tokenServicesUrl" : "https://myserver.domain.com/portal/sharing/rest/generateToken"
	  },
	"provider-knowledge": {
		"sources": {
			"MyKnowledgeService": {
				"url": "https://myserver.domain.com/server/rest/services/Hosted/MyKnowledgeService/KnowledgeGraphServer"
			}
		}
	}
}
```