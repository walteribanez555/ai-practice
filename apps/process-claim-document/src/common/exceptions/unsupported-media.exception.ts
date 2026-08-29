import { HttpException } from './http.exception';

/** 415 Unsupported Media Type — MIME type not accepted. */
export class UnsupportedMediaException extends HttpException {
  constructor(message = 'Unsupported Media Type', code?: string) {
    super(415, message, code);
  }
}
