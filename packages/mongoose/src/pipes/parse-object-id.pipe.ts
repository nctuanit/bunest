import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from "@bunest/common";
import { ObjectId } from "../driver/object-id";

@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, ObjectId> {
  transform(value: string): ObjectId {
    const isValidObjectId = ObjectId.isValid(value);
    if (!isValidObjectId) {
      throw new BadRequestException(
        `Invalid ObjectId: '${value}' is not a valid MongoDB ObjectId`,
      );
    }
    return new ObjectId(value);
  }
}
