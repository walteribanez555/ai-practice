import type { UserRole } from '../../app.types';

export interface JwtPayload {
  sub:   string;    // userId
  email: string;
  role:  UserRole;
  iat?:  number;
  exp?:  number;
}

export interface LoginDto {
  email:    string;
  password: string;
}

export interface AuthResponseDto {
  token:     string;
  expiresIn: number;
  userId:    string;
  role:      UserRole;
}
