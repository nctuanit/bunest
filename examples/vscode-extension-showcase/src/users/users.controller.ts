import { Body, Controller, Delete, Get, Param, Post, Query } from "@bunest/core";
import { UsersEventsListener } from "./users.events";
import { UsersService, type CreateUserInput } from "./users.service";

/**
 * 👉 Chạy `bun run dev` rồi bấm CodeLens `▶ Send GET /users` ngay trên mỗi route!
 * 👉 Xem Sidebar Bunest -> Routes để gọi nhanh hoặc Copy URL!
 */
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly eventsListener: UsersEventsListener,
  ) {}

  @Get()
  async list(@Query("minAge") minAge?: string) {
    const users = minAge
      ? await this.usersService.findAdults(Number(minAge))
      : await this.usersService.findAll();
    return {
      banner: this.usersService.getRuntimeBanner(),
      count: users.length,
      users,
    };
  }

  @Get("audit")
  async auditLog() {
    return {
      channel: this.eventsListener.getAuditChannelName(),
      entries: await this.eventsListener.getAuditHistory(),
    };
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    return this.usersService.findByIdOrThrow(Number(id));
  }

  @Post()
  async create(@Body() body: CreateUserInput) {
    return this.usersService.create(body);
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    return this.usersService.remove(Number(id));
  }
}
