const {
    AUDIENCE_MODE_MARKETING,
    AUDIENCE_MODE_RIFA_PARTICIPANTS,
    resolverPoliticaAudienciaCampana,
    resolverModoAudienciaJob
} = require('../backend/services/pushCampaignQueueService');

describe('pushCampaignQueueService audience segmentation', () => {
    test('usa audiencia comercial para nueva rifa publicada', () => {
        expect(resolverModoAudienciaJob({
            event_type: 'nueva_rifa_publicada'
        })).toBe(AUDIENCE_MODE_MARKETING);
    });

    test('usa audiencia de compradores de la rifa para recordatorios y resultados', () => {
        expect(resolverModoAudienciaJob({
            event_type: 'presorteo_proximo'
        })).toBe(AUDIENCE_MODE_RIFA_PARTICIPANTS);
        expect(resolverModoAudienciaJob({
            event_type: 'sorteo_proximo'
        })).toBe(AUDIENCE_MODE_RIFA_PARTICIPANTS);
        expect(resolverModoAudienciaJob({
            event_type: 'resultados_disponibles'
        })).toBe(AUDIENCE_MODE_RIFA_PARTICIPANTS);
    });

    test('normaliza la politica de audiencia con defaults y clamps seguros', () => {
        expect(resolverPoliticaAudienciaCampana({})).toEqual({
            marketingRecencyDays: 120
        });

        expect(resolverPoliticaAudienciaCampana({
            audiencePolicy: {
                marketingRecencyDays: 15
            }
        })).toEqual({
            marketingRecencyDays: 30
        });

        expect(resolverPoliticaAudienciaCampana({
            audiencePolicy: {
                marketingRecencyDays: 5000
            }
        })).toEqual({
            marketingRecencyDays: 3650
        });
    });
});
