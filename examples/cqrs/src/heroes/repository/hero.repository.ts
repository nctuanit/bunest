import { Injectable, NotFoundException } from "@bunest/core";
import { Hero } from "../models/hero.model";

@Injectable()
export class HeroRepository {
  private readonly heroes = new Map<string, Hero>([
    ["hero-1", new Hero("hero-1", "Arthur")],
    ["hero-2", new Hero("hero-2", "Brienne")],
  ]);

  findOneById(id: string): Hero {
    const hero = this.heroes.get(id);
    if (!hero) {
      throw new NotFoundException(`Hero "${id}" not found`);
    }
    return hero;
  }

  findAll(): Hero[] {
    return [...this.heroes.values()];
  }
}
