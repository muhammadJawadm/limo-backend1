const axios = require('axios');

const getGoogleMapsClient = () => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    // console.log('Google Maps API Key:', apiKey);
    if (!apiKey) {
        throw new Error('GOOGLE_MAPS_API_KEY environment variable is not set');
    }
    return apiKey;
};

const calculateDistance = async (pickupLocation, dropoffLocation, stopLocations = []) => {
    try {
        const apiKey = getGoogleMapsClient();
        const waypoints = stopLocations && stopLocations.length > 0 ? stopLocations : [];

        // Build waypoints string for Google Maps API
        let waypointsParam = '';
        if (waypoints.length > 0) {
            waypointsParam = `&waypoints=${waypoints.map((loc) => encodeURIComponent(loc)).join('|')}`;
        }

        const origin = encodeURIComponent(pickupLocation);
        const destination = encodeURIComponent(dropoffLocation);

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}${waypointsParam}&key=${apiKey}&units=imperial`;

        const response = await axios.get(url);

        if (response.data.status !== 'OK') {
            throw new Error(`Google Maps API error: ${response.data.status} - ${response.data.error_message}`);
        }

        if (!response.data.rows || response.data.rows.length === 0 || !response.data.rows[0].elements) {
            throw new Error('No distance data returned from Google Maps API');
        }

        const element = response.data.rows[0].elements[0];
        if (element.status !== 'OK') {
            throw new Error(`Google Maps routing error: ${element.status}`);
        }

        // Distance is in meters, convert to miles
        const distanceMeters = element.distance.value;
        const distanceMiles = distanceMeters / 1609.34;

        return {
            distanceMiles: parseFloat(distanceMiles.toFixed(2)),
            durationSeconds: element.duration.value,
        };
    } catch (error) {
        throw new Error(`Distance calculation failed: ${error.message}`);
    }
};

module.exports = {
    calculateDistance,
};
