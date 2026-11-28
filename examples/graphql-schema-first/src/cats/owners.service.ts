import { Injectable } from "@bunest/core";

export interface OwnerRecord {
  readonly id: number;
  readonly name: string;
}

@Injectable()
export class OwnersService {
  private readonly owners: OwnerRecord[] = [
    { id: 1, name: "Jon" },
    { id: 2, name: "Liz" },
  ];

  findOneById(id: number): OwnerRecord | null {
    return this.owners.find((owner) => owner.id === id) ?? null;
  }
}
