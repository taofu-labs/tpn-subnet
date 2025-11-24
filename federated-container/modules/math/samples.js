import jStat from 'jstat'

/**
 * Calculates the sample size using Cochran's formula with finite population correction.
 * @param {Object} params - Sample size parameters.
 * @param {number} [params.uptime_confidence_fraction=0.99] - Confidence level (e.g., 0.99 for 99%).
 * @param {number} [params.expected_proportion_up=0.99] - Expected proportion of nodes that are up.
 * @param {number} [params.error_margin=0.05] - Desired margin of error.
 * @param {number} params.node_count - Total population size.
 * @returns {number} - Required sample size (rounded up).
 */
export function cochrane_sample_size( { uptime_confidence_fraction=.99, expected_proportion_up=.99, error_margin=.05, node_count } ) {

    // Calculate the z-score for the desired confidence level
    const alpha = 1 - uptime_confidence_fraction
    const cumulative_probability = 1 - alpha / 2
    const z_score = jStat.normal.inv( cumulative_probability, 0, 1 )

    // Unadjusted sample size
    const sample_size = z_score**2 * expected_proportion_up * ( 1- expected_proportion_up )  / error_margin**2

    // Do a finite population correction
    const fpc_sample_size = sample_size / ( 1 + ( sample_size - 1 ) / node_count )

    return Math.ceil( fpc_sample_size )

}