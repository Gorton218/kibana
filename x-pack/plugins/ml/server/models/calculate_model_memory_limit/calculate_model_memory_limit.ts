/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import numeral from '@elastic/numeral';
import { APICaller } from 'kibana/server';
import { AnalysisConfig } from '../../../common/types/anomaly_detection_jobs';
import { fieldsServiceProvider } from '../fields_service';

interface ModelMemoryEstimationResult {
  /**
   * Result model memory limit
   */
  modelMemoryLimit: string;
  /**
   * Estimated model memory by elasticsearch ml endpoint
   */
  estimatedModelMemoryLimit: string;
  /**
   * Maximum model memory limit
   */
  maxModelMemoryLimit?: string;
}

/**
 * Response of the _estimate_model_memory endpoint.
 */
export interface ModelMemoryEstimate {
  model_memory_estimate: string;
}

/**
 * Retrieves overall and max bucket cardinalities.
 */
async function getCardinalities(
  callAsCurrentUser: APICaller,
  analysisConfig: AnalysisConfig,
  indexPattern: string,
  query: any,
  timeFieldName: string,
  earliestMs: number,
  latestMs: number
): Promise<{
  overallCardinality: { [key: string]: number };
  maxBucketCardinality: { [key: string]: number };
}> {
  /**
   * Fields not involved in cardinality check
   */
  const excludedKeywords = new Set<string>(
    /**
     * The keyword which is used to mean the output of categorization,
     * so it will have cardinality zero in the actual input data.
     */
    'mlcategory'
  );

  const fieldsService = fieldsServiceProvider(callAsCurrentUser);

  const { detectors, influencers, bucket_span: bucketSpan } = analysisConfig;

  let overallCardinality = {};
  let maxBucketCardinality = {};
  const overallCardinalityFields: Set<string> = detectors.reduce(
    (
      acc,
      {
        by_field_name: byFieldName,
        partition_field_name: partitionFieldName,
        over_field_name: overFieldName,
      }
    ) => {
      [byFieldName, partitionFieldName, overFieldName]
        .filter(field => field !== undefined && field !== '' && !excludedKeywords.has(field))
        .forEach(key => {
          acc.add(key as string);
        });
      return acc;
    },
    new Set<string>()
  );

  const maxBucketFieldCardinalities: string[] = influencers.filter(
    influencerField =>
      typeof influencerField === 'string' &&
      !excludedKeywords.has(influencerField) &&
      !!influencerField &&
      !overallCardinalityFields.has(influencerField)
  ) as string[];

  if (overallCardinalityFields.size > 0) {
    overallCardinality = await fieldsService.getCardinalityOfFields(
      indexPattern,
      [...overallCardinalityFields],
      query,
      timeFieldName,
      earliestMs,
      latestMs
    );
  }

  if (maxBucketFieldCardinalities.length > 0) {
    maxBucketCardinality = await fieldsService.getMaxBucketCardinalities(
      indexPattern,
      maxBucketFieldCardinalities,
      query,
      timeFieldName,
      earliestMs,
      latestMs,
      bucketSpan
    );
  }

  return {
    overallCardinality,
    maxBucketCardinality,
  };
}

export function calculateModelMemoryLimitProvider(callAsCurrentUser: APICaller) {
  /**
   * Retrieves an estimated size of the model memory limit used in the job config
   * based on the cardinality of the fields being used to split the data
   * and influencers.
   */
  return async function calculateModelMemoryLimit(
    analysisConfig: AnalysisConfig,
    indexPattern: string,
    query: any,
    timeFieldName: string,
    earliestMs: number,
    latestMs: number,
    allowMMLGreaterThanMax = false
  ): Promise<ModelMemoryEstimationResult> {
    let maxModelMemoryLimit;
    try {
      const resp = await callAsCurrentUser('ml.info');
      if (resp?.limits?.max_model_memory_limit !== undefined) {
        maxModelMemoryLimit = resp.limits.max_model_memory_limit.toUpperCase();
      }
    } catch (e) {
      throw new Error('Unable to retrieve max model memory limit');
    }

    const { overallCardinality, maxBucketCardinality } = await getCardinalities(
      callAsCurrentUser,
      analysisConfig,
      indexPattern,
      query,
      timeFieldName,
      earliestMs,
      latestMs
    );

    const estimatedModelMemoryLimit = (
      await callAsCurrentUser<ModelMemoryEstimate>('ml.estimateModelMemory', {
        body: {
          analysis_config: analysisConfig,
          overall_cardinality: overallCardinality,
          max_bucket_cardinality: maxBucketCardinality,
        },
      })
    ).model_memory_estimate.toUpperCase();

    let modelMemoryLimit: string = estimatedModelMemoryLimit;
    // if max_model_memory_limit has been set,
    // make sure the estimated value is not greater than it.
    if (!allowMMLGreaterThanMax && maxModelMemoryLimit !== undefined) {
      // @ts-ignore
      const maxBytes = numeral(maxModelMemoryLimit).value();
      // @ts-ignore
      const mmlBytes = numeral(estimatedModelMemoryLimit).value();
      if (mmlBytes > maxBytes) {
        // @ts-ignore
        modelMemoryLimit = `${Math.floor(maxBytes / numeral('1MB').value())}MB`;
      }
    }

    return {
      estimatedModelMemoryLimit,
      modelMemoryLimit,
      ...(maxModelMemoryLimit ? { maxModelMemoryLimit } : {}),
    };
  };
}
