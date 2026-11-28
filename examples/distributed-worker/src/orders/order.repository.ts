import { Repository } from "@bunest/orm";
import type { OrderEntity } from "./order.entity";

@Repository<OrderEntity, number>()
export abstract class OrderRepository {
  async updateStatus(id: number, status: string): Promise<number> {
    const res = await this.execute(
      "UPDATE orders SET status = :status WHERE id = :id",
      { id, status },
    );
    return res.affectedRows;
  }
}
