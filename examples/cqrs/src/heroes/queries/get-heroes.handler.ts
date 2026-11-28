import { QueryHandler, type IQueryHandler } from "@bunest/messaging/cqrs";
import { HeroRepository } from "../repository/hero.repository";
import { GetHeroesQuery } from "./get-heroes.query";

@QueryHandler(GetHeroesQuery)
export class GetHeroesHandler implements IQueryHandler<GetHeroesQuery> {
  constructor(private readonly repository: HeroRepository) {}

  execute() {
    return this.repository.findAll().map((hero) => hero.toJSON());
  }
}
