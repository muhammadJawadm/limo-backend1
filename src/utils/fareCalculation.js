const calculateFareForPtoP = (distanceMiles, perMileRate30, perMileRate40) => {
    // For point-to-point: up to 30 miles use perMileRate30, over 30 miles also use perMileRate30 (as per requirement for miles 31-40)
    // Over 40 miles use perMileRate40
    if (distanceMiles <= 40) {
        return distanceMiles * perMileRate30;
    } else {
        // First 40 miles at rate30, remaining at rate40
        const rate30Charge = 40 * perMileRate30;
        const rate40Charge = (distanceMiles - 40) * perMileRate40;
        return rate30Charge + rate40Charge;
    }
};

const calculateTotalFare = (bookingType, distanceMiles, hours, baseFare, perMileRate30, perMileRate40, perHour) => {
    let tripPrice = 0;

    if (bookingType === 'ptop') {
        // Point-to-point pricing
        tripPrice = baseFare + calculateFareForPtoP(distanceMiles, perMileRate30, perMileRate40);
    } else if (bookingType === 'hourly') {
        // Hourly pricing (not based on distance)
        if (!hours || hours <= 0) {
            throw new Error('hours must be specified for hourly booking');
        }
        tripPrice = baseFare + (hours * perHour);
    } else {
        throw new Error('Invalid booking type');
    }

    return parseFloat(tripPrice.toFixed(2));
};

const calculateFareBreakdown = (bookingType, distanceMiles, hours, baseFare, perMileRate30, perMileRate40, perHour) => {
    let breakdown = {
        baseFare,
        mileageCharge: 0,
        hourlyCharge: 0,
        distanceMiles,
    };

    if (bookingType === 'ptop') {
        breakdown.mileageCharge = calculateFareForPtoP(distanceMiles, perMileRate30, perMileRate40);
    } else if (bookingType === 'hourly') {
        if (!hours || hours <= 0) {
            throw new Error('hours must be specified for hourly booking');
        }
        breakdown.hourlyCharge = hours * perHour;
        breakdown.hours = hours;
    }

    breakdown.subtotal = parseFloat((breakdown.baseFare + breakdown.mileageCharge + breakdown.hourlyCharge).toFixed(2));
    return breakdown;
};

const calculateToll = (distanceMiles, tollRate = 0.15) => {
    // Toll charges: $0.15 per mile (configurable)
    // Alternative: could use fixed charges for distance brackets or integrate with toll API
    if (distanceMiles <= 5) {
        return 0; // No toll for short distances
    }
    // Charge toll for distance beyond 5 miles
    const tollableDistance = distanceMiles - 5;
    return parseFloat((tollableDistance * tollRate).toFixed(2));
};

module.exports = {
    calculateFareForPtoP,
    calculateTotalFare,
    calculateFareBreakdown,
    calculateToll,
};
