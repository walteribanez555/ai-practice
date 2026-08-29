export type UserRole = 'client' | 'adjuster';

export interface LoginRequest {
  email:    string;
  password: string;
}

export interface LoginResponse {
  token:     string;
  expiresIn: number;
  userId:    string;
  role:      UserRole;
}

export interface AuthUser {
  userId: string;
  email:  string;
  role:   UserRole;
}
