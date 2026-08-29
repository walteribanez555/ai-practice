import { HttpException } from './http.exception';

/** 500 Internal Server Error — unrecoverable server-side failure. */
export class InternalException extends HttpException {
  constructor(message = 'Internal Server Error', code?: string) {
    super(500, message, code);
  }
}
