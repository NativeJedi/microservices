import { AbstractDocument } from './abstract.schema';
import { Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { Logger, NotFoundException } from '@nestjs/common';

export abstract class AbstractRepository<TDocument extends AbstractDocument> {
  protected abstract readonly logger: Logger;

  constructor(private readonly model: Model<TDocument>) {}

  async create(document: Omit<TDocument, '_id'>): Promise<TDocument> {
    const created = new this.model({
      ...document,
      _id: new Types.ObjectId(),
    });

    return (await created.save()).toJSON() as TDocument;
  }

  async findOne(filterQuery: QueryFilter<TDocument>): Promise<TDocument> {
    const document = await this.model
      .findOne(filterQuery)
      .lean<TDocument>(true);

    if (!document) {
      this.logger.warn(`Document not found: ${JSON.stringify(filterQuery)}`);
      throw new NotFoundException('Document not found');
    }

    return document;
  }

  async findOneAndUpdate(
    filterQuery: QueryFilter<TDocument>,
    updateQuery: UpdateQuery<TDocument>,
  ): Promise<TDocument> {
    const document = await this.model
      .findOneAndUpdate(filterQuery, updateQuery, { new: true })
      .lean<TDocument>(true);

    if (!document) {
      this.logger.warn(`Document not found: ${JSON.stringify(filterQuery)}`);
      throw new NotFoundException('Document not found');
    }

    return document;
  }

  async find(filterQuery: QueryFilter<TDocument>): Promise<TDocument[]> {
    return this.model.find(filterQuery).lean<TDocument[]>(true);
  }

  async findOneAndDelete(
    filterQuery: QueryFilter<TDocument>,
  ): Promise<TDocument> {
    const document = await this.model
      .findOneAndDelete(filterQuery, {
        new: true,
      })
      .lean<TDocument>(true);

    if (!document) {
      this.logger.warn(`Document not found: ${JSON.stringify(filterQuery)}`);
      throw new NotFoundException('Document not found');
    }

    return document;
  }
}
