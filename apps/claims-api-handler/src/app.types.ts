export type UserRole = 'client' | 'adjuster';

export interface AppVariables {
  userId:    string;
  userRole:  UserRole;
  userEmail: string;
}

export type AppEnv = { Variables: AppVariables };
