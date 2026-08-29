import { ClaimEntity } from '../../orm/entities/claim.entity';
import type { CreateClaimInput, UpdateClaimInput } from '../../orm/entities/claim.entity';
import type { FindManyOptions } from '../../orm/orm';

export class ClaimModel {
  static findAll(options?: FindManyOptions)           { return ClaimEntity.findAll(options); }
  static findById(id: string)                         { return ClaimEntity.findById(id); }
  static findByClientId(cid: string, o?: FindManyOptions) { return ClaimEntity.findByClientId(cid, o); }
  static findRecentByClientId(cid: string, since: Date)   { return ClaimEntity.findRecentByClientId(cid, since); }
  static create(input: CreateClaimInput)              { return ClaimEntity.create(input); }
  static update(id: string, input: UpdateClaimInput)  { return ClaimEntity.update(id, input); }
  static delete(id: string)                           { return ClaimEntity.delete(id); }
}
