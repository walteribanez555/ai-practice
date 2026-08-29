import { HttpException } from './http.exception';

/** 422 Unprocessable Entity — valid request but business rules rejected it. */
export class UnprocessableException extends HttpException {
  constructor(message = 'Unprocessable Entity', code?: string) {
    super(422, message, code);
  }
}
