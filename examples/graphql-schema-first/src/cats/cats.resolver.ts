import { ParseIntPipe, UseGuards } from "@bunest/core";
import {
  Args,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "@bunest/graphql";
import { CatsGuard } from "./cats.guard";
import { CatsService, type CatRecord } from "./cats.service";
import { OwnersService, type OwnerRecord } from "./owners.service";

@Resolver("Cat")
export class CatsResolver {
  constructor(
    private readonly catsService: CatsService,
    private readonly ownersService: OwnersService,
  ) {}

  @Query("cats")
  getCats(): CatRecord[] {
    return this.catsService.findAll();
  }

  @Query("cat")
  findOneById(@Args("id", ParseIntPipe) id: number): CatRecord | null {
    return this.catsService.findOneById(id);
  }

  @Mutation("createCat")
  @UseGuards(CatsGuard)
  create(
    @Args("createCatInput")
    input: { name: string; age: number; ownerId?: number },
  ): CatRecord {
    return this.catsService.create(input);
  }

  @ResolveField("owner")
  getOwner(@Parent() cat: CatRecord): OwnerRecord | null {
    return cat.ownerId ? this.ownersService.findOneById(cat.ownerId) : null;
  }
}
