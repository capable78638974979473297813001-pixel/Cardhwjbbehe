export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new HttpError(400, code, message, extra);
export const unauthorized = (message = 'Missing or invalid token') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (code, message, extra) => new HttpError(403, code, message, extra);
export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const conflict = (code, message) => new HttpError(409, code, message);
