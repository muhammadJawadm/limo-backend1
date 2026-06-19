const TAX_RATE = 0.0825;

const calculateTax = (pretaxAmount) =>
    parseFloat((Number(pretaxAmount) * TAX_RATE).toFixed(2));

const calculateFareForPtoP = (distanceMiles, perMileRate30, perMileRate40) => {
    const d = Number(distanceMiles);
    const r30 = Number(perMileRate30);
    const r40 = Number(perMileRate40);
    if (d <= 40) {
        return d * r30;
    } else {
        return (40 * r30) + ((d - 40) * r40);
    }
};

const calculateTotalFare = (bookingType, distanceMiles, hours, baseFare, perMileRate30, perMileRate40, perHour) => {
    const base = Number(baseFare);
    const d    = Number(distanceMiles);
    const h    = Number(hours);
    const r30  = Number(perMileRate30);
    const r40  = Number(perMileRate40);
    const rh   = Number(perHour);
    let tripPrice = 0;

    if (bookingType === 'ptop') {
        tripPrice = base + calculateFareForPtoP(d, r30, r40);
    } else if (bookingType === 'hourly') {
        if (!h || h <= 0) {
            throw new Error('hours must be specified for hourly booking');
        }
        tripPrice = base + (h * rh);
    } else {
        throw new Error('Invalid booking type');
    }

    return parseFloat(tripPrice.toFixed(2));
};

const calculateFareBreakdown = (bookingType, distanceMiles, hours, baseFare, perMileRate30, perMileRate40, perHour) => {
    const base = Number(baseFare);
    const d    = Number(distanceMiles);
    const h    = Number(hours);
    const r30  = Number(perMileRate30);
    const r40  = Number(perMileRate40);
    const rh   = Number(perHour);

    const breakdown = {
        baseFare: base,
        mileageCharge: 0,
        hourlyCharge: 0,
        distanceMiles: d,
    };

    if (bookingType === 'ptop') {
        breakdown.mileageCharge = calculateFareForPtoP(d, r30, r40);
    } else if (bookingType === 'hourly') {
        if (!h || h <= 0) {
            throw new Error('hours must be specified for hourly booking');
        }
        breakdown.hourlyCharge = h * rh;
        breakdown.hours = h;
    }

    breakdown.subtotal = parseFloat((breakdown.baseFare + breakdown.mileageCharge + breakdown.hourlyCharge).toFixed(2));
    return breakdown;
};

const calculateToll = (distanceMiles, tollRate = 0.15) => {
    const d = Number(distanceMiles);
    if (d <= 5) {
        return 0;
    }
    return parseFloat(((d - 5) * tollRate).toFixed(2));
};

module.exports = {
    TAX_RATE,
    calculateTax,
    calculateFareForPtoP,
    calculateTotalFare,
    calculateFareBreakdown,
    calculateToll,
};
