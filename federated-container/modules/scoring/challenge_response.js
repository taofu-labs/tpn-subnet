import { v4 as uuidv4 } from 'uuid'
import { write_challenge_solution_pair } from '../database/challenge_response.js'
import { log } from 'mentie'
import { base_url } from '../networking/url.js'

/**
 * Generates a challenge-solution pair for verification purposes.
 * @param {Object} [params] - Parameters for generating a challenge.
 * @param {string} [params.tag] - Optional tag to associate with the challenge.
 * @returns {Promise<{challenge: string, solution: string, challenge_url: string}>} - The generated challenge, solution, and challenge URL.
 */
export async function generate_challenge( { tag }={} ) {

    // Generate new challenge id
    const challenge = uuidv4()

    // Generate new response value
    const solution = uuidv4()

    // Save the challenge and response to the database
    await write_challenge_solution_pair( { challenge, solution, tag } )

    // Formulate public challenge URL
    let challenge_url = new URL( base_url )
    challenge_url.pathname = `/protocol/challenge/${ challenge }`
    if( tag ) challenge_url.searchParams.set( 'tag', tag )
    challenge_url = challenge_url.toString()
    log.info( `New challenge url generated: ${ challenge_url }` )

    // Log generation
    log.debug( `Generated new challenge/response pair:`, { challenge, solution, challenge_url, tag } )

    return { challenge, solution, challenge_url }

}