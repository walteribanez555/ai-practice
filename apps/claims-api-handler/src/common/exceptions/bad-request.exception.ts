import { HttpException } from './http.exception';

/** 400 Bad Request — missing or malformed input. */
export class BadRequestException extends HttpException {
  constructor(message = 'Bad Request', code?: string) {
    super(400, message, code);
  }
}
