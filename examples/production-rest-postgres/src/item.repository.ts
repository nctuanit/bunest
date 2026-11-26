import { Repository } from "@bunest/orm";
import type { ItemEntity } from "./item.entity";

@Repository<ItemEntity, number>()
export abstract class ItemRepository {}
