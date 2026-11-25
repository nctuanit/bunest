import { CrudRepository, OrmRepository } from "@bunest/orm";
import { ItemEntity } from "./item.entity";

@OrmRepository(ItemEntity)
export abstract class ItemRepository extends CrudRepository<
  ItemEntity,
  number
> {}
