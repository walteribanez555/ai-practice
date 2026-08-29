/** Generic success envelope — { data: T } */
export interface IApiResponse<T = unknown> {
  data: T;
}

/** Standard error envelope — { error: string, code?: string } */
export interface IApiErrorResponse {
  error: string;
  code?: string;
}
