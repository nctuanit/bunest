import { Injectable } from "@bunest/core";

export interface CatRecord {
  readonly id: number;
  readonly name: string;
  readonly age: number;
  readonly ownerId?: number;
}

@Injectable()
export class CatsService {
  private readonly cats: CatRecord[] = [
    { id: 1, name: "Garfield", age: 5, ownerId: 1 },
  ];
  private nextId = 2;

  findAll(): CatRecord[] {
    return [...this.cats];
  }

  findOneById(id: number): CatRecord | null {
    return this.cats.find((c) => c.id === id) ?? null;
  }

  create(input: { name: string; age: number; ownerId?: number }): CatRecord {
    const cat: CatRecord = {
      id: this.nextId++,
      name: input.name,
      age: input.age,
      ownerId: input.ownerId ?? 1,
    };
    this.cats.push(cat);
    return cat;
  }
}
