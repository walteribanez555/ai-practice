export type UserRole = 'client' | 'adjuster';

export interface AppVariables {
  userId:   string;
  userRole: UserRole;
}

export type AppEnv = { Variables: AppVariables };
