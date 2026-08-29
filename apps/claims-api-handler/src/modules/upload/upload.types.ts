export const ALLOWED_CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png:  'image/png',
  pdf:  'application/pdf',
} as const;

export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

export const PRESIGN_EXPIRES_IN = 300; // 5 minutes

export interface PresignRequestDto {
  contentType: AllowedContentType;
}

export interface PresignResponseDto {
  documentKey: string;  // pass this to POST /claims
  uploadUrl:   string;  // PUT the file here directly
  expiresIn:   number;
  mimeType:    string;
}
