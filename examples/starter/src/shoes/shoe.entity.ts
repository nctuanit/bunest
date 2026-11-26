import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "@bunest/orm";
import { BrandEntity } from "../brands/brand.entity";

@Entity("shoes")
export class ShoeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Unique()
  sku: string;

  @Column()
  @Index()
  name: string;

  @Column()
  category: string;

  @Column("integer")
  size: number;

  @Column("integer")
  price: number;

  @Column("integer")
  stock: number = 0;

  @Column()
  active: boolean = true;

  @ManyToOne(() => BrandEntity, (brand) => brand.shoes)
  @JoinColumn({ name: "brand_id" })
  brand: BrandEntity;
}
