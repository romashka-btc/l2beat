import { ConfigMapping } from '@l2beat/config'
import { assert, PremintedEntry, ProjectId } from '@l2beat/shared-pure'
import { TvlConfig } from '../../../config/Config'
import { MulticallClient } from '../../../peripherals/multicall/MulticallClient'
import { BlockTimestampIndexer } from '../indexers/BlockTimestampIndexer'
import { DescendantIndexer } from '../indexers/DescendantIndexer'
import { PremintedIndexer } from '../indexers/PremintedIndexer'
import { ValueIndexer } from '../indexers/ValueIndexer'
import { AmountService } from '../services/AmountService'
import { TvlDependencies } from './TvlDependencies'

interface PremintedModule {
  start: () => Promise<void> | void
}

export function initPremintedModule(
  config: TvlConfig,
  dependencies: TvlDependencies,
  configMapping: ConfigMapping,
  descendantPriceIndexer: DescendantIndexer,
  blockTimestampIndexers?: Map<string, BlockTimestampIndexer>,
): PremintedModule | undefined {
  const { dataIndexers, valueIndexers } = createIndexers(
    config,
    dependencies,
    configMapping,
    descendantPriceIndexer,
    blockTimestampIndexers,
  )

  if (dataIndexers.length === 0) return undefined

  return {
    start: async () => {
      for (const dataIndexer of dataIndexers) {
        await dataIndexer.start()
      }

      for (const valueIndexer of valueIndexers) {
        await valueIndexer.start()
      }
    },
  }
}

function createIndexers(
  config: TvlConfig,
  dependencies: TvlDependencies,
  configMapping: ConfigMapping,
  descendantPriceIndexer: DescendantIndexer,
  blockTimestampIndexers?: Map<string, BlockTimestampIndexer>,
) {
  const logger = dependencies.logger.tag({ module: 'preminted' })
  const indexerService = dependencies.indexerService
  const syncOptimizer = dependencies.syncOptimizer
  const circulatingSupplyService = dependencies.circulatingSupplyService
  const valueService = dependencies.valueService

  const dataIndexers: PremintedIndexer[] = []
  const valueIndexers: ValueIndexer[] = []

  for (const chainConfig of config.chains) {
    const chain = chainConfig.chain
    if (!chainConfig.config) {
      continue
    }

    const premintedTokens = config.amounts
      .filter((a) => a.chain === chain)
      .filter((a): a is PremintedEntry => a.type === 'preminted')

    if (premintedTokens.length === 0) {
      continue
    }

    const rpcClient = dependencies.clients.getRpcClient(chain)

    const amountService = new AmountService({
      rpcClient: rpcClient,
      multicallClient: new MulticallClient(
        rpcClient,
        chainConfig.config.multicallConfig,
      ),
      logger: logger.tag({ tag: chain, chain }),
    })

    const blockTimestampIndexer =
      blockTimestampIndexers && blockTimestampIndexers.get(chain)
    assert(
      blockTimestampIndexer,
      'blockTimestampIndexer should be defined for enabled chain',
    )

    for (const preminted of premintedTokens) {
      const indexer = new PremintedIndexer({
        logger,
        parents: [blockTimestampIndexer],
        indexerService,
        configuration: preminted,
        minHeight: preminted.sinceTimestamp.toNumber(),
        amountService,
        circulatingSupplyService,
        syncOptimizer,
        db: dependencies.database,
      })

      dataIndexers.push(indexer)

      const valueIndexer = new ValueIndexer({
        valueService,
        db: dependencies.database,
        priceConfigs: [configMapping.getPriceConfigFromAmountConfig(preminted)],
        amountConfigs: [preminted],
        project: ProjectId(preminted.project),
        dataSource: `${chain}_preminted_${preminted.address}`,
        syncOptimizer,
        parents: [descendantPriceIndexer, indexer],
        indexerService,
        logger,
        minHeight: preminted.sinceTimestamp.toNumber(),
        maxHeight: preminted.untilTimestamp?.toNumber(),
        maxTimestampsToProcessAtOnce: config.maxTimestampsToAggregateAtOnce,
      })

      valueIndexers.push(valueIndexer)
    }
  }
  return { dataIndexers, valueIndexers }
}
