// One error body for every client error in the API (openapi.yaml: components/schemas/Error).
const MORE_INFO = '/api-docs#error-codes';

function errorBody(code, message, details = []) {
  return { code, message, details, more_info: MORE_INFO };
}

// Thrown by routes and services; the central error handler turns it into a response.
class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// e.g. throw notFound('PROVINCE_NOT_FOUND', 'No province with id PV-99.')
function notFound(code, message) {
  return new ApiError(404, code, message);
}

module.exports = { ApiError, errorBody, notFound };
