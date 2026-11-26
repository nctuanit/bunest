import {
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/orm";
import { ShoeEntity } from "../shoes/shoe.entity";

@Entity("brands")
export class BrandEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Unique()
  name: string;

  @Column()
  country: string;

  @OneToMany(() => ShoeEntity, (shoe) => shoe.brand)
  shoes: ShoeEntity[];
}
