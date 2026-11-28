import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type Logger,
} from "@bunest/core";
import { InjectRepository, Transactional, type OrmRepository } from "@bunest/orm";
import { ShoeEntity } from "../shoes/shoe.entity";
import { ShoeRepository } from "../shoes/shoe.repository";
import type { CreateOrderDto } from "./create-order.dto";
import { OrderItemEntity } from "./order-item.entity";
import { OrderEntity, type OrderStatus } from "./order.entity";
import { OrderRepository, type SalesSummary } from "./order.repository";

@Injectable()
export class OrdersService {
  declare readonly logger: Logger;

  constructor(
    private readonly orderRepo: OrderRepository,
    @InjectRepository(OrderEntity)
    private readonly orderOrmRepo: OrmRepository<OrderEntity>,
    private readonly shoeRepo: ShoeRepository,
    @InjectRepository(ShoeEntity)
    private readonly shoeOrmRepo: OrmRepository<ShoeEntity>,
  ) {}

  findAll(status?: OrderStatus): Promise<OrderEntity[]> {
    return this.orderOrmRepo.find({
      ...(status ? { where: { status } } : {}),
      relations: { items: { shoe: { brand: true } } },
      order: { id: "DESC" },
    });
  }

  async findOne(id: number): Promise<OrderEntity> {
    const order = await this.orderOrmRepo.findOne({
      where: { id },
      relations: { items: { shoe: { brand: true } } },
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  getSalesSummary(): Promise<SalesSummary> {
    return this.orderRepo.getSalesSummary();
  }

  @Transactional()
  async placeOrder(dto: CreateOrderDto): Promise<OrderEntity> {
    const order = new OrderEntity();
    order.orderCode = `SNK-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
    order.customerName = dto.customerName;
    order.customerPhone = dto.customerPhone;
    order.status = "PENDING";

    const items: OrderItemEntity[] = [];
    let totalAmount = 0;

    for (const line of dto.items) {
      const shoe = await this.shoeOrmRepo.findOne({
        where: { id: line.shoeId },
        relations: { brand: true },
      });
      if (!shoe || !shoe.active) {
        throw new NotFoundException(`Shoe #${line.shoeId} not found`);
      }

      const reserved = await this.shoeRepo.decrementStock(shoe.id, line.quantity);
      if (!reserved) {
        throw new BadRequestException(
          `Insufficient stock for "${shoe.name}" (available: ${shoe.stock}, requested: ${line.quantity})`,
        );
      }

      const item = new OrderItemEntity();
      item.order = order;
      item.shoe = shoe;
      item.quantity = line.quantity;
      item.size = shoe.size;
      item.unitPrice = shoe.price;
      items.push(item);

      totalAmount += shoe.price * line.quantity;
    }

    order.totalAmount = totalAmount;
    order.items = items;

    const saved = await this.orderOrmRepo.save(order);
    this.logger.log(
      `Placed order ${saved.orderCode} (${items.length} line(s), total ${saved.totalAmount} VND)`,
    );
    return this.findOne(saved.id);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<OrderEntity> {
    const order = await this.findOne(id);
    order.status = status;
    await this.orderOrmRepo.save(order);
    return this.findOne(id);
  }
}
