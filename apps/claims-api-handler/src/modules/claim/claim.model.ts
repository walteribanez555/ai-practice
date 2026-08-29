import { ClaimEntity } from '../../orm/entities/claim.entity';
import type { CreateClaimInput, UpdateClaimInput } from '../../orm/entities/claim.entity';
import type { ClaimStatus, Priority } from './claim.types';

export class ClaimModel {
  static findAll()                                           { return ClaimEntity.findAll(); }
  static findById(id: string)                                { return ClaimEntity.findById(id); }
  static findByClientId(clientId: string)                    { return ClaimEntity.findByClientId(clientId); }
  static findRecentByClientId(clientId: string, since: Date) { return ClaimEntity.findRecentByClientId(clientId, since); }
  static findByStatus(status: ClaimStatus)                   { return ClaimEntity.findByStatus(status); }
  static findByPriority(priority: Priority)                  { return ClaimEntity.findByPriority(priority); }
  static create(input: CreateClaimInput)                     { return ClaimEntity.create(input); }
  static update(id: string, input: UpdateClaimInput)         { return ClaimEntity.update(id, input); }
  static delete(id: string)                                  { return ClaimEntity.delete(id); }
}
