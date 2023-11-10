const Resource = require("./resource");
const middleware = require("./middleware");

module.exports = {
  Resource,
  handle: middleware.handle,
  RequestParams: middleware.RequestParams,
  ResponseParams: middleware.ResponseParams,
  ResponseType: middleware.ResponseType,
};
