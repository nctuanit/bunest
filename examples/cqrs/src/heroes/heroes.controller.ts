import { Body, Controller, Get, Param, Post } from "@bunest/core";
import { CommandBus, QueryBus } from "@bunest/messaging/cqrs";
import { KillDragonCommand } from "./commands/hero.commands";
import { HeroEventJournal } from "./events/hero-event.handlers";
import { GetHeroesQuery } from "./queries/get-heroes.query";

@Controller("hero")
export class HeroesGameController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly journal: HeroEventJournal,
  ) {}

  @Post(":id/kill")
  async killDragon(
    @Param("id") id: string,
    @Body() body: { dragonId: string },
  ) {
    return this.commandBus.execute(new KillDragonCommand(id, body.dragonId));
  }

  @Get()
  async findAll() {
    return this.queryBus.execute(new GetHeroesQuery());
  }

  @Get("events")
  getEventJournal(): string[] {
    return [...this.journal.entries];
  }
}
