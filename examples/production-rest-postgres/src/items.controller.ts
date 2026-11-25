import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@bunest/core";
import { CreateItemDto } from "./item.dto";
import { ItemsService, type ItemResponse } from "./items.service";

@Controller("/items")
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateItemDto): Promise<ItemResponse> {
    return this.itemsService.create(dto);
  }

  @Get(":id")
  findOne(@Param("id") id: string): Promise<ItemResponse> {
    return this.itemsService.findById(id);
  }
}
