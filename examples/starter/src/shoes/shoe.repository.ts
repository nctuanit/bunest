import { CrudRepository, Repository } from "@bunest/orm";
import { ShoeEntity } from "./shoe.entity";

@Repository(ShoeEntity)
export abstract class ShoeRepository extends CrudRepository<ShoeEntity, number> {
  abstract findBySku(sku: string): Promise<ShoeEntity | null>;

  abstract existsBySku(sku: string): Promise<boolean>;

  abstract findAllByCategory(category: string): Promise<ShoeEntity[]>;

  searchShoes(params: {
    pattern: string;
    minPrice?: number;
    maxPrice?: number;
  }): Promise<Array<ShoeEntity & { brandName: string }>> {
    return this.query<ShoeEntity & { brandName: string }>(
      `SELECT s.*, b.name AS brandName
       FROM shoes s
       INNER JOIN brands b ON b.id = s.brand_id
       WHERE s.active = 1
         AND (s.name LIKE :pattern OR b.name LIKE :pattern OR s.sku LIKE :pattern)
         AND s.price >= :minPrice
         AND s.price <= :maxPrice
       ORDER BY s.price ASC`,
      {
        pattern: params.pattern,
        minPrice: params.minPrice ?? 0,
        maxPrice: params.maxPrice ?? 1_000_000_000,
      },
    );
  }

  async decrementStock(id: number, quantity: number): Promise<boolean> {
    const res = await this.execute(
      "UPDATE shoes SET stock = stock - :quantity WHERE id = :id AND stock >= :quantity",
      { id, quantity },
    );
    return res.affectedRows > 0;
  }
}
