import { Inject } from "@bunest/common";
import { getConnectionToken, getModelToken } from "./mongoose.utils";

export const InjectModel = (
  model: string,
  connectionName?: string,
): PropertyDecorator & ParameterDecorator =>
  Inject(getModelToken(model, connectionName));

export const InjectConnection = (
  name?: string,
): PropertyDecorator & ParameterDecorator => Inject(getConnectionToken(name));
