import { Injectable, NotFoundException } from "@bunest/core";
import type { CreateCatDto } from "./dto/create-cat.dto";
import type { Cat } from "./interfaces/cat.interface";

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [
    { id: 1, name: "Milo", age: 3, breed: "British Shorthair", createdBy: "seed" },
  ];
  private nextId = 2;

  create(dto: CreateCatDto, createdBy: string): Cat {
    const cat: Cat = {
      id: this.nextId++,
      name: dto.name,
      age: dto.age,
      breed: dto.breed,
      createdBy,
    };
    this.cats.push(cat);
    return cat;
  }

  findAll(): Cat[] {
    return [...this.cats];
  }

  findOne(id: number): Cat {
    const found = this.cats.find((cat) => cat.id === id);
    if (!found) {
      throw new NotFoundException(`Cat #${id} not found`);
    }
    return found;
  }
}
