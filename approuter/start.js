"use strict";

// Mirati Studio approuter entry point.
//
// Wraps the standard @sap/approuter and mounts the SAP ADT smart-proxy (see
// lib/adt-proxy.js) ahead of the approuter's own request handling. The proxy is
// registered on `first` so it runs BEFORE the approuter's XSUAA/session auth:
// it authenticates each call itself via getDestination({ jwt }) using the Bearer
// token, so it needs no approuter session. Any path other than `/adt-proxy/*`
// falls through to the normal approuter routes (xs-app.json: /api, SPA, assets).

const approuter = require("@sap/approuter");
const adtProxy = require("./lib/adt-proxy");

const ar = approuter();
ar.first.use("/adt-proxy", adtProxy);
ar.start();
