export class ApiError extends Error {
  constructor(message, code = 'GENERIC') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}