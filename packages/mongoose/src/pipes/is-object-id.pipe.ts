import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from "@bunest/common";
import { ObjectId } from "../driver/object-id";

@Injectable()
export class IsObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const isValidObjectId = ObjectId.isValid(value);
    if (!isValidObjectId) {
      throw new BadRequestException(
        `Invalid ObjectId: '${value}' is not a valid MongoDB ObjectId`,
      );
    }
    return value;
  }
}
