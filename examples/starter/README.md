# Bunest Sneaker Shop (Starter Example)

Project mẫu **Shop bán giày** có đầy đủ quan hệ Entity, Transaction, Validation và Declarative Repository:

## Quan hệ Entity (`@bunest/orm`)
- `BrandEntity` (`1`) ↔ (`N`) `ShoeEntity` (`@OneToMany` / `@ManyToOne` + `@JoinColumn({ name: "brand_id" })`)
- `OrderEntity` (`1`) ↔ (`N`) `OrderItemEntity` (`@OneToMany(..., { cascade: true })` / `@ManyToOne(..., { onDelete: "CASCADE" })`)
- `OrderItemEntity` (`N`) → (`1`) `ShoeEntity` (`@ManyToOne`)

## API Endpoints
- `GET /health`
- `GET/POST /brands`, `GET /brands/:id` (kèm `shoes`)
- `GET/POST /shoes`, `GET/PATCH/DELETE /shoes/:id` (kèm `brand`, tìm kiếm JOIN bằng `this.query`)
- `GET/POST /orders`, `GET /orders/:id`, `GET /orders/stats`, `PATCH /orders/:id/status` (đặt nhiều đôi trong 1 `@Transactional()`, rollback tự động nếu có 1 mẫu hết hàng)

## Chạy thử
```bash
bun run --cwd examples/starter dev
bun test examples/starter
```
