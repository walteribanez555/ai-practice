import type { FindManyOptions } from '../orm/orm';

export type FindAllAction<T> = (options?: FindManyOptions) => Promise<T[]>;
export type FindByIdAction<T> = (id: string) => Promise<T | null>;
export type FindByFieldAction<T> = (value: string) => Promise<T | null>;
export type CreateAction<T, I> = (input: I) => Promise<T>;
export type UpdateAction<T, I> = (id: string, input: I) => Promise<T | null>;
export type DeleteAction = (id: string) => Promise<boolean>;

export interface CrudService<T, CreateInput, UpdateInput> {
  findAll: FindAllAction<T>;
  findById: FindByIdAction<T>;
  create: CreateAction<T, CreateInput>;
  update: UpdateAction<T, UpdateInput>;
  delete: DeleteAction;
}
