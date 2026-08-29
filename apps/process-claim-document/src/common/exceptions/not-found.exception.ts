import { HttpException } from './http.exception';

/** 404 Not Found — resource does not exist. */
export class NotFoundException extends HttpException {
  constructor(message = 'Not Found', code?: string) {
    super(404, message, code);
  }
}
