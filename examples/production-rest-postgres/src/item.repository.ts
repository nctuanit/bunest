import { Repository } from "@bunest/orm";
import { ItemEntity } from "./item.entity";

@Repository(ItemEntity)
export abstract class ItemRepository {}
